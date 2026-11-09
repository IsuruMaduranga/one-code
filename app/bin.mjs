#!/usr/bin/env node
/**
 * The bundled app's command. It checks the Node version, finds the extension
 * package named by this package's `productExtension` field, and hands over to
 * its `createApp` (extensions/lib/app/create-app.mjs), which takes every name from
 * the profile's brand. A product's app is this same file: only package.json
 * differs, stamped from the brand (scripts/apply-brand.mjs).
 *
 * Deliberately plain JS with no imports beyond node builtins until the Node
 * version is checked: pi crashes on Node < 22.19 at import time (bundled
 * undici), so the friendly error must come first.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
const app = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
const command = Object.keys(app.bin ?? {})[0] ?? "the app";

// --- Node version gate (before any pi import) ----------------------------
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
	process.stderr.write(
		`${command} requires Node >= 22.19 (you are running ${process.versions.node}).\n` +
			`Older Node crashes inside pi's bundled HTTP client at startup.\n` +
			`Install a newer Node (https://nodejs.org) and try again.\n`,
	);
	process.exit(1);
}

// The launcher lives in the extension package; an install that lacks it (a
// missing or older extension copy) gets the fix, not a module-not-found trace.
const require = createRequire(import.meta.url);
let createAppPath;
try {
	createAppPath = join(dirname(require.resolve(`${app.productExtension}/package.json`)), "extensions", "lib", "app", "create-app.mjs");
} catch {}
if (!createAppPath || !existsSync(createAppPath)) {
	process.stderr.write(
		`${command} ${app.version} cannot start: ${createAppPath ? `the installed ${app.productExtension} package is from an older release` : `the ${app.productExtension} package is not installed`}.\n` +
			`Reinstall the app: npm install -g ${app.name}\n`,
	);
	process.exit(1);
}
const corePath = dirname(dirname(dirname(createAppPath)));
const { createApp } = await import(pathToFileURL(createAppPath).href);
await createApp({ appVersion: app.version, corePath, argv: process.argv, resolve: (specifier) => import.meta.resolve(specifier) });
