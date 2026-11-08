/**
 * Shared harness for testing inline-extension tool_call handlers directly
 * (the child permission gate and its sibling factories from
 * extensions/lib/agent-loader.ts) without building a real resource loader.
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { permissionGateFactory } from "../../../extensions/lib/permission-gate.ts";
import { writeRepositorySettings, writeUserSettings } from "./settings-files.ts";

export type ToolCallHandler = (event: {
	toolName: string;
	input: Record<string, unknown>;
}) =>
	| Promise<{ block?: boolean; reason?: string } | undefined>
	| { block?: boolean; reason?: string }
	| undefined;

/** Capture an inline extension's tool_call handler for direct-call testing. */
export function captureToolCallHandler(ext: InlineExtension): ToolCallHandler {
	const factory = typeof ext === "function" ? ext : ext.factory;
	let handler: ToolCallHandler | undefined;
	factory({
		on: (event: string, h: ToolCallHandler) => {
			if (event === "tool_call") handler = h;
		},
	} as never);
	if (!handler) throw new Error("extension did not register a tool_call handler");
	return handler;
}

/**
 * A permission gate over a fresh temp cwd/home. `settings` goes to the
 * profile's primary user settings file (allow rules there apply directly);
 * `projectSettings` to the repository's settings file, whose allow rules need
 * consent (a profile without one needs `useRepositorySettings()`).
 */
export function buildGate(
	settings: object,
	getBridge?: Parameters<typeof permissionGateFactory>[3],
	projectSettings?: object,
): { handler: ToolCallHandler; cwd: string; home: string } {
	const cwd = mkdtempSync(join(os.tmpdir(), "gate-cwd-"));
	const home = mkdtempSync(join(os.tmpdir(), "gate-home-"));
	writeUserSettings(cwd, home, settings);
	if (projectSettings) writeRepositorySettings(cwd, home, projectSettings);
	return { handler: captureToolCallHandler(permissionGateFactory(cwd, home, undefined, getBridge)), cwd, home };
}

/** Rebuild a gate over existing dirs (e.g. after persisting a consent). */
buildGate.rebuild = (cwd: string, home: string): ToolCallHandler =>
	captureToolCallHandler(permissionGateFactory(cwd, home, undefined, undefined));
