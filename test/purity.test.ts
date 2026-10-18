import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The engine must be pure: no wall clock, no ambient randomness. Anything
// that needs time or chance gets it from the tick counter or a named RNG
// stream. This scan is the enforcement, not a convention.
const BANNED = ["Math.random", "Date.now", "performance.now", "process.hrtime"];

function collectSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...collectSources(path));
    else if (entry.endsWith(".ts")) found.push(path);
  }
  return found;
}

describe("purity", () => {
  const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
  const files = [
    ...collectSources(join(srcRoot, "kernel")),
    ...collectSources(join(srcRoot, "demo")),
  ];

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const banned of BANNED) {
    it(`no source under src/kernel or src/demo uses ${banned}`, () => {
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        expect(text.includes(banned), `${file} contains ${banned}`).toBe(
          false,
        );
      }
    });
  }
});
