#!/usr/bin/env node
/**
 * one-code — the bundled One Code app.
 *
 * A thin launcher around the pinned pi harness in this package's dependency
 * tree. It does four things before handing argv to pi's `main()`:
 *
 * 1. Isolates all state under ~/.one-code (PI_CODING_AGENT_DIR), so an
 *    existing `pi` install on the same machine is never touched.
 * 2. Registers the one-code-extension package (from our own node_modules)
 *    in the isolated settings, so pi's package manager loads the extensions,
 *    themes, and bundled agents exactly as a `pi install` would.
 * 3. Rewrites the few plain-stdout lines where pi prints its own command
 *    name (the resume hint, --help usage) — under isolation `pi --session
 *    <id>` would not just be mis-branded but broken, since stock pi cannot
 *    see ~/.one-code sessions.
 * 4. Suppresses pi's own update check and installs One Code's instead
 *    (update-check.mjs), with an install-method-aware upgrade hint.
 *
 * Deliberately plain JS with no imports beyond node builtins until the Node
 * version is checked: pi crashes on Node < 22.19 at import time (bundled
 * undici), so the friendly error must come first.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// --- 0. Node version gate (before any pi import) -------------------------
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
	process.stderr.write(
		`one-code requires Node >= 22.19 (you are running ${process.versions.node}).\n` +
			`Older Node crashes inside pi's bundled HTTP client at startup.\n` +
			`Install a newer Node (https://nodejs.org) and try again.\n`,
	);
	process.exit(1);
}

const require = createRequire(import.meta.url);
const appDir = dirname(fileURLToPath(import.meta.url));
const appVersion = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version;

// --- 1. Isolated state ----------------------------------------------------
process.env.PI_CODING_AGENT_DIR ||= join(homedir(), ".one-code", "agent");
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
		settings = { theme: "one-code", quietStartup: true, tuiMode: "fullscreen" };
	}
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
	const changed = firstRun || packages.length !== next.length || packages.some((p, i) => sourceOf(p) !== sourceOf(next[i]));
	if (changed) {
		settings.packages = next;
		writeFileSync(settingsPath, JSON.stringify(settings, null, "\t") + "\n");
	}
} catch (error) {
	// Fail loud but keep launching: a broken settings file is the user's to
	// fix, and pi will surface its own diagnostics for it too.
	process.stderr.write(`one-code: could not register extensions in ${settingsPath}: ${error?.message ?? error}\n`);
}

// --- 3. Surgical stdout rebranding ----------------------------------------
// Only plain-text lines pi prints OUTSIDE the TUI are touched (the resume
// hint after the TUI stops, and --help/usage output). Never rewrite inside
// arbitrary chunks: TUI escape streams must pass through byte-identical.
const rewriteHelp = argv.includes("--help") || argv.includes("-h");
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
	if (typeof chunk === "string") {
		// The label may carry ANSI styling (chalk.dim), so match the command
		// part: "…To resume this session:</dim> pi --session <id>[ --session-dir …]".
		if (chunk.includes("To resume this session:")) {
			chunk = chunk.replaceAll(" pi --session ", " one-code --session ");
		}
		if (rewriteHelp) {
			// Standalone word "pi" only; "pi.dev", "pi-coding-agent" etc. survive.
			chunk = chunk.replace(/(^|[\s"'`])pi(?=$|[\s"'`])/gm, "$1one-code");
		}
	}
	return originalWrite(chunk, ...rest);
};

// --- 4. Launch pi with One Code's update check ----------------------------
const { AssistantMessageComponent, InteractiveMode, main } = await import("@earendil-works/pi-coding-agent");

// Clean exit. pi 0.84.1's quit path leaves the rendered UI behind in both TUI
// modes: fullscreen deliberately switches from the alt screen back to the
// main-screen renderer and repaints the whole transcript into scrollback
// (stopInteractiveTui → switchTuiMode("regular") + renderNow); regular mode
// just parks the cursor below the rendered lines. One Code wants the Claude
// Code exit: restore the terminal, print only the resume hint. Overriding this
// one method keeps the mid-session /settings renderer switch untouched.
// Exact-pinned pi makes the private internals (renderer, hasOverlayEntries,
// ui, and the main-screen render bookkeeping) stable; re-verify on every pin
// bump. Upstream proposal queued (an exit-preserve setting).
try {
	const original = InteractiveMode.prototype.stopInteractiveTui;
	if (typeof original === "function") {
		InteractiveMode.prototype.stopInteractiveTui = function stopInteractiveTuiPreserving() {
			try {
				const renderer = this.renderer;
				if (renderer?.mode === "fullscreen") {
					while (renderer.hasOverlayEntries) renderer.hideOverlay();
					this.ui.stop({ preserveScreen: true });
					return;
				}
				// Regular (main-screen) mode: erase the on-screen part of the
				// working area, then stop without the stock cursor-park. Only
				// the viewport can be erased — lines already scrolled into
				// scrollback stay (clearing scrollback would take ESC[3J,
				// which also destroys the user's own shell history).
				if (
					renderer?.mode === "regular" &&
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
			} catch {
				// Any surprise in pi's internals: fall through to stock behavior.
			}
			return original.call(this);
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
				upgradeHint: installedViaBrew ? "brew upgrade one-code" : "npm install -g @one-ai/one-code",
			}),
		},
	],
});
