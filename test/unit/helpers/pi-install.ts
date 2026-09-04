/**
 * Paths into the pi build these tests run against: the devDep pin under the
 * repo's own `node_modules`.
 *
 * pi's exports map blocks both a CJS main and `"./package.json"`, so tests that
 * need to read its `package.json` or reach into its `dist/` have to locate the
 * package by path rather than by resolution. Shared here so the spelling lives
 * in one place — two test files had grown their own variants.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** This repo's root. */
export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** The installed `@earendil-works/pi-coding-agent` package root. */
export const piRoot = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");

/** Its compiled, unbundled output — the tree a library consumer loads. */
export const piDist = join(piRoot, "dist");

/** pi-tui's compiled output, nested under pi by its shrinkwrap. */
export const piTuiDist = join(piRoot, "node_modules", "@earendil-works", "pi-tui", "dist");
