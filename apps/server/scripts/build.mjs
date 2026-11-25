// Bundles the server into dist/main.mjs, the operator commands into
// dist/cli.mjs, and the Sentry start-up into dist/instrument.mjs (loaded
// first with node --import). npm dependencies stay
// external (they are installed in the image), @sentry/node too: its tracing
// hooks into packages such as pg as they load, which does not work from
// inside a bundle. The workspace package (@iam/shared) is bundled.
import { build } from "esbuild";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith("@iam/"));

await rm(path.join(root, "dist"), { recursive: true, force: true });
await build({
  entryPoints: {
    main: path.join(root, "src/main.ts"),
    instrument: path.join(root, "src/instrument.ts"),
    cli: path.join(root, "src/cli.ts"),
  },
  outdir: path.join(root, "dist"),
  outExtension: { ".js": ".mjs" },
  // One copy of shared code (Sentry) for both entry points.
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  external,
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
  // Some dependencies still call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
