/**
 * Paths into the pi build these tests run against: the devDep pin under the
 * repo's own `node_modules`.
 *
 * pi's exports map blocks both a CJS main and `"./package.json"`, so tests that
 * need to read its `package.json` or reach into its `dist/` have to locate the
 * package by path rather than by resolution. Shared here so the spelling lives
 * in one place — two test files had grown their own variants.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiTuiEntry } from "../../../extensions/subagents/prose.ts";

/** This repo's root. */
export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** The installed `@earendil-works/pi-coding-agent` package root. */
export const piRoot = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");

/** Its compiled, unbundled output — the tree a library consumer loads. */
export const piDist = join(piRoot, "dist");

/** pi-tui's compiled output: the copy pi loads, nested under it or hoisted. */
export const piTuiDist = dirname(resolvePiTuiEntry());
