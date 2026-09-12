#!/usr/bin/env node
/**
 * onecode — the bundled One Code app.
 *
 * A thin launcher around the pinned pi harness in this package's dependency
 * tree. It does four things before handing argv to pi's `main()`:
 *
 * 1. Isolates all state under ~/.onecode (PI_CODING_AGENT_DIR), so an
 *    existing `pi` install on the same machine is never touched.
 * 2. Registers the one-code-extension package (from our own node_modules)
 *    in the isolated settings, so pi's package manager loads the extensions,
 *    themes, and bundled agents exactly as a `pi install` would.
 * 3. Rewrites the few plain-stdout lines where pi prints its own command
 *    name (the resume hint, --help usage) — under isolation `pi --session
 *    <id>` would not just be mis-branded but broken, since stock pi cannot
 *    see ~/.onecode sessions.
 * 4. Suppresses pi's own update check and installs One Code's instead
 *    (update-check.mjs), with an install-method-aware upgrade hint.
 *
 * Two subcommands never reach pi: `onecode --version` (the app's version) and
 * `onecode doctor` (the setup report, extensions/doctor/cli.ts).
 *
 * Deliberately plain JS with no imports beyond node builtins until the Node
 * version is checked: pi crashes on Node < 22.19 at import time (bundled
 * undici), so the friendly error must come first.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// --- 0. Node version gate (before any pi import) -------------------------
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
	process.stderr.write(
		`onecode requires Node >= 22.19 (you are running ${process.versions.node}).\n` +
			`Older Node crashes inside pi's bundled HTTP client at startup.\n` +
			`Install a newer Node (https://nodejs.org) and try again.\n`,
	);
	process.exit(1);
}

const require = createRequire(import.meta.url);
const appDir = dirname(fileURLToPath(import.meta.url));
const appVersion = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version;

// --- 1. Isolated state ----------------------------------------------------
process.env.PI_CODING_AGENT_DIR ||= join(homedir(), ".onecode", "agent");
process.env.PI_SKIP_VERSION_CHECK = "1"; // One Code ships its own update check
process.env.CC_VERSION ||= appVersion; // the banner shows the app version
const agentDir = process.env.PI_CODING_AGENT_DIR;

// --- fast path: --version reports the app, not the harness ----------------
const argv = process.argv.slice(2);
if (argv[0] === "--version" || argv[0] === "-v") {
	// pi's exports map blocks "<pkg>/package.json" and carries only an
	// `import` condition (no CJS require.resolve); resolve the ESM entry
	// (<pkg>/dist/index.js) and walk up instead.
	const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const piPackageJson = join(dirname(dirname(piEntry)), "package.json");
	const piVersion = JSON.parse(readFileSync(piPackageJson, "utf8")).version;
	process.stdout.write(`${appVersion} (pi ${piVersion})\n`);
	process.exit(0);
}

// --- fast path: `onecode doctor` prints the setup report without a session --
// Claude Code's `claude doctor`. It must work on the machine it exists for —
// one with no provider yet — so it never goes through pi's session bootstrap:
// the extension's report module is loaded through pi's own TypeScript loader
// (jiti, a pi dependency) and reads pi's auth/model files directly. The
// extension package is registered first (step 2 below) so the report sees the
// same settings a session would.
const runDoctor = argv[0] === "doctor";

// --- 2. Register the extension package in the isolated settings -----------
// pi resolves local-path package sources in place (no copying), so pointing
// the isolated settings at our node_modules copy loads extensions in manifest
// order plus themes and bundled agents — and app upgrades propagate because
// the path tracks node_modules content. The entry is re-ensured every launch:
// npm may relocate node_modules (different Node/prefix), and a stale path
// from a previous install must be replaced, not accumulated.
const corePath = dirname(require.resolve("one-code-extension/package.json"));
const settingsPath = join(agentDir, "settings.json");
try {
	mkdirSync(agentDir, { recursive: true });
	let settings;
	let firstRun = false;
	if (existsSync(settingsPath)) {
		settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
			throw new Error(`${settingsPath} is not a JSON object`);
		}
	} else {
		firstRun = true;
		// Seeding settings also skips pi's first-time setup, which would offer
		// pi's stock themes; One Code's own theme is the branded first-run.
		// Fullscreen (alt-screen) is the One Code look — the TUI owns the
		// screen and exits clean. Seeded only here, so users who switch back
		// to regular mode keep their choice.
		settings = { theme: "onecode", quietStartup: true, tuiMode: "fullscreen" };
	}
	// pi 0.85.0 made the clean fullscreen exit reachable from settings
	// (stopInteractiveTui skips the transcript repaint and stops with
	// preserveScreen unless fullscreenExitOutput is "transcript"), which is
	// the Claude Code exit One Code used to get by patching that method.
	// Backfill the key once for sessions seeded before 0.85.0; an explicit
	// value, "transcript" included, is the user's and is never rewritten.
	const backfillExitOutput = settings.fullscreenExitOutput === undefined;
	if (backfillExitOutput) settings.fullscreenExitOutput = "resume-hint";
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	const sourceOf = (entry) => (typeof entry === "string" ? entry : entry?.source);
	// "Ours" = any path ending in /node_modules/one-code-extension (stale npm
	// roots included). User-added packages are left untouched.
	const isOurs = (entry) => {
		const source = sourceOf(entry);
		return typeof source === "string" && /[/\\]node_modules[/\\]one-code-extension$/.test(source);
	};
	const kept = packages.filter((entry) => !isOurs(entry) && sourceOf(entry) !== corePath);
	const next = [...kept, corePath];
	const changed =
		firstRun ||
		backfillExitOutput ||
		packages.length !== next.length ||
		packages.some((p, i) => sourceOf(p) !== sourceOf(next[i]));
	if (changed) {
		settings.packages = next;
		// Write-then-rename: a crash mid-write must not leave a truncated
		// settings.json that the next launch reports as unregistered extensions
		// (review L4). Rename is atomic within the same directory. Same pattern as
		// the extensions' lib/atomic-write.ts, inlined to keep bin.mjs import-free.
		const tempPath = `${settingsPath}.${process.pid}.tmp`;
		writeFileSync(tempPath, JSON.stringify(settings, null, "\t") + "\n");
		renameSync(tempPath, settingsPath);
	}
} catch (error) {
	// Fail loud but keep launching: a broken settings file is the user's to
	// fix, and pi will surface its own diagnostics for it too.
	process.stderr.write(`onecode: could not register extensions in ${settingsPath}: ${error?.message ?? error}\n`);
}

if (runDoctor) {
	process.exitCode = await runDoctorCli();
	process.exit();
}

/**
 * Load `extensions/doctor/cli.ts` with pi's own jiti and run it. pi's loader
 * aliases `@earendil-works/pi-ai` onto its compat entry for extension code;
 * mirrored here so the module resolves the same way it does inside a session.
 * Any failure prints a plain error and exits 2 — a diagnostic that crashes
 * with a stack trace is worse than none.
 */
async function runDoctorCli() {
	try {
		const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const piRequire = createRequire(piEntry);
		const piVersion = JSON.parse(readFileSync(join(dirname(dirname(piEntry)), "package.json"), "utf8")).version;
		const jitiModule = await import(pathToFileURL(piRequire.resolve("jiti")).href);
		const createJiti = jitiModule.createJiti ?? jitiModule.default;
		const alias = {};
		try {
			// Mirror pi's own extension loader (dist/core/extensions/loader.js
			// getAliases): the bare specifier AND /compat resolve to the compat
			// entry, while /oauth and /providers/all resolve to their own real
			// files. jiti applies aliases by PREFIX, so with only the bare key an
			// import of `@earendil-works/pi-ai/compat` is rewritten to the dead
			// `<compat.js>/compat` — which crashed `onecode doctor`, whose graph
			// reaches pi-web-search's `/compat` import (dependencies.ts). The
			// explicit subpath keys give jiti an exact match that wins over the
			// bare prefix, so a doctor run resolves pi-ai exactly as a session does.
			const compatEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/compat"));
			alias["@earendil-works/pi-ai"] = compatEntry;
			alias["@earendil-works/pi-ai/compat"] = compatEntry;
			for (const sub of ["oauth", "providers/all"]) {
				try {
					alias[`@earendil-works/pi-ai/${sub}`] = fileURLToPath(import.meta.resolve(`@earendil-works/pi-ai/${sub}`));
				} catch {
					// Subpath absent in this pi-ai build; skip it.
				}
			}
		} catch {
			// No compat entry (older pi-ai): plain resolution of the root entry serves.
		}
		const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true, alias });
		const { runDoctorCli: run } = await jiti.import(join(corePath, "extensions", "doctor", "cli.ts"));
		return await run({
			agentDir,
			cwd: process.cwd(),
			home: homedir(),
			env: process.env,
			version: appVersion,
			install: "app",
			piVersion,
			columns: process.stdout.columns,
		});
	} catch (error) {
		process.stderr.write(`onecode doctor: could not run the diagnostics: ${error?.stack ?? error}\n`);
		return 2;
	}
}

// --- 3. Surgical stdout rebranding ----------------------------------------
// Only plain-text lines pi prints OUTSIDE the TUI are touched (the resume
// hint after the TUI stops, and --help/usage output). Never rewrite inside
// arbitrary chunks: TUI escape streams must pass through byte-identical. And
// only in the interactive TUI or for --help: `-p`/`--print`/`--mode json|rpc`
// output is parsed by other programs (or is a model's answer) and must never
// be altered, so those modes leave stdout untouched.
const rewriteHelp = argv.includes("--help") || argv.includes("-h");
const machineOutput = argv.includes("-p") || argv.includes("--print") || argv.includes("--mode");
if (rewriteHelp || !machineOutput) {
	const originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk, ...rest) => {
		if (typeof chunk === "string") {
			// The label may carry ANSI styling (chalk.dim), so match the command
			// part: "…To resume this session:</dim> pi --session <id>[ --session-dir …]".
			if (chunk.includes("To resume this session:")) {
				chunk = chunk.replaceAll(" pi --session ", " onecode --session ");
			}
			if (rewriteHelp) {
				// Standalone word "pi" only: preceded by start/whitespace/quote, and
				// NOT followed by a word char, "." or "-". The negative lookahead means
				// any trailing punctuation (`,`, `]`, `:`, …) is rewritten without
				// another patch, while "pi.dev" and "pi-coding-agent" survive (review L4a).
				chunk = chunk.replace(/(^|[\s"'`])pi(?![\w.\-])/gm, "$1onecode");
			}
		}
		return originalWrite(chunk, ...rest);
	};
}

// --- 4. Launch pi with One Code's update check ----------------------------
const { AssistantMessageComponent, InteractiveMode, main } = await import("@earendil-works/pi-coding-agent");

// The two prototype patches below reach into pi internals that a pin bump can
// rename. A patch that does not take falls back to stock behaviour silently for
// users; with ONECODE_DEBUG=1 it says so, and test/unit/app-bin-patches.test.ts
// asserts the patched members exist in the pinned build.
const patchMissed = (what) => {
	if (process.env.ONECODE_DEBUG) process.stderr.write(`onecode: pi internals changed, ${what} not patched (stock behaviour)\n`);
};

// Clean exit in regular (main-screen) mode. One Code wants the Claude Code
// exit: restore the terminal, print only the resume hint. pi 0.85.0 delivers
// that for FULLSCREEN by itself — stopInteractiveTui skips the transcript
// repaint and stops with preserveScreen unless fullscreenExitOutput is
// "transcript" — so the seeded "resume-hint" setting above covers that mode
// and this patch no longer touches it. Regular mode is still stock pi's
// park-the-cursor-below-the-lines exit, which leaves banner, editor and
// footer on screen, so that half stays here. Overriding this one method keeps
// the mid-session /settings renderer switch untouched. Exact-pinned pi makes
// the private internals (renderer, ui, and the main-screen render
// bookkeeping) stable; re-verify on every pin bump. Upstream proposal queued
// for the regular-mode half.
try {
	const original = InteractiveMode.prototype.stopInteractiveTui;
	if (typeof original !== "function") patchMissed("InteractiveMode.prototype.stopInteractiveTui");
	if (typeof original === "function") {
		InteractiveMode.prototype.stopInteractiveTui = function stopInteractiveTuiPreservingRegular(fullscreenExitOutput) {
			try {
				const renderer = this.renderer;
				// Regular (main-screen) mode: erase the on-screen part of the
				// working area, then stop without the stock cursor-park. Only
				// the viewport can be erased — lines already scrolled into
				// scrollback stay (clearing scrollback would take ESC[3J,
				// which also destroys the user's own shell history).
				if (renderer?.mode === "regular") {
					// (renderer fields verified by app-bin-patches.test.ts against the pinned pi)
					if (
						Array.isArray(renderer.previousLines) &&
						renderer.previousLines.length > 0 &&
						Number.isInteger(renderer.hardwareCursorRow) &&
						Number.isInteger(renderer.previousViewportTop)
					) {
						let buffer = "";
						if (renderer.previousKittyImageIds && typeof renderer.deleteKittyImages === "function") {
							buffer += renderer.deleteKittyImages(renderer.previousKittyImageIds);
						}
						const rowsUp = Math.max(0, renderer.hardwareCursorRow - renderer.previousViewportTop);
						if (rowsUp > 0) buffer += `\x1b[${rowsUp}A`;
						buffer += "\r\x1b[0J";
						renderer.terminal.write(buffer);
						this.ui.stop({ preserveScreen: true });
						return;
					}
					patchMissed("renderer shape for the clean-exit path");
				}
			} catch {
				// Any surprise in pi's internals: fall through to stock behavior.
			}
			// Fullscreen lands here by design: pi 0.85.0 does the clean exit
			// itself, driven by the fullscreenExitOutput it passes through.
			return original.call(this, fullscreenExitOutput);
		};
	}
} catch {
	// InteractiveMode not patchable (unexpected pi build): stock exit behavior.
}

// Suppress pi's red "Operation aborted" line on a user interrupt. The
// interrupted extension shows Claude Code's dim "Interrupted · What should One
// Code do instead?" note in its place, so pi's own abort line is a duplicate.
// pi's AssistantMessageComponent.updateContent (assistant-message.js) appends
// that line whenever the message stopReason is "aborted" and it carries no tool
// calls (aborted tool calls surface the error on the tool component instead, so
// those are left alone). We run the original with the stopReason briefly coerced
// to "stop" — the only branch that reads it for an aborted, tool-call-free
// message — then restore it, so nothing downstream (the interrupted extension's
// agent_end check, session persistence) ever sees a changed message. This is an
// app-only patch: users on stock pi (`pi install one-code-extension`) still get
// pi's line. Exact-pinned pi keeps this stable; re-verify on every pin bump.
try {
	const original = AssistantMessageComponent.prototype.updateContent;
	if (typeof original !== "function") patchMissed("AssistantMessageComponent.prototype.updateContent");
	if (typeof original === "function") {
		AssistantMessageComponent.prototype.updateContent = function updateContentWithoutAbortLine(message, ...rest) {
			const hasToolCalls = Array.isArray(message?.content) && message.content.some((c) => c?.type === "toolCall");
			if (message?.stopReason === "aborted" && !hasToolCalls) {
				const realStopReason = message.stopReason;
				message.stopReason = "stop";
				try {
					return original.call(this, message, ...rest);
				} finally {
					message.stopReason = realStopReason;
				}
			}
			return original.call(this, message, ...rest);
		};
	}
} catch {
	// AssistantMessageComponent not patchable (unexpected pi build): stock behavior.
}
const { createUpdateCheck } = await import("./update-check.mjs");
const brewPrefixes = ["/opt/homebrew/", "/usr/local/Cellar/", "/home/linuxbrew/"];
let installedViaBrew = false;
try {
	const binPath = realpathSync(process.argv[1] ?? "");
	installedViaBrew = brewPrefixes.some((prefix) => binPath.startsWith(prefix));
} catch {
	// Unresolvable argv[1] (unusual embedding): assume npm.
}
await main(argv, {
	extensionFactories: [
		{
			name: "one-code-update-check",
			factory: createUpdateCheck({
				currentVersion: appVersion,
				stampPath: join(agentDir, "last-update-check"),
				upgradeHint: installedViaBrew ? "brew upgrade onecode" : "npm install -g @one-ai/one-code",
			}),
		},
	],
});
