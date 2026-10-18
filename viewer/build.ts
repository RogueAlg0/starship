// Bundles the viewer (and the engine it runs) into viewer/dist/bundle.js.
// The viewer is a separate layer: this bundles ../src unchanged, it does
// not modify it.
//
// With --static, instead writes viewer/dist-static/index.html: the same
// page with the bundle inlined, one self-contained file for publishing
// behind a single link.
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const entry = root + "src/main.ts";

if (process.argv.includes("--static")) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    target: "es2022",
    write: false,
    logLevel: "info",
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error("esbuild produced no output");
  const html = await readFile(root + "index.html", "utf8");
  const tag = '<script src="./dist/bundle.js"></script>';
  if (!html.includes(tag)) {
    throw new Error(`viewer/index.html is missing the bundle tag: ${tag}`);
  }
  const safe = output.text.replace(/<\/script/gi, "<\\/script");
  const inlined = html.replace(tag, () => `<script>\n${safe}\n</script>`);
  await mkdir(root + "dist-static", { recursive: true });
  await writeFile(root + "dist-static/index.html", inlined);
  console.log("wrote viewer/dist-static/index.html");
} else {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    target: "es2022",
    outfile: root + "dist/bundle.js",
    sourcemap: true,
    logLevel: "info",
  });
}
