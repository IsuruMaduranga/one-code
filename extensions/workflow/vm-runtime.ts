/**
 * Executes a parsed workflow script body inside a fresh `node:vm` context.
 *
 * The context gets exactly one host binding — `__workflow__`, the globals
 * object — and none of the host's intrinsics (the vm realm supplies its own
 * Math/Date/Promise/etc., which the prelude then neuters for determinism).
 * The vm `timeout` only bounds the synchronous prefix of execution (up to the
 * first await); async runaway is bounded by the agent/budget caps inside the
 * injected agent(), not here.
 */

import vm from "node:vm";
import type { ScriptGlobals } from "./globals.ts";
import { wrapScriptBody } from "./script-source.ts";
import { WorkflowScriptError } from "./types.ts";

const SYNC_TIMEOUT_MS = 5_000;

export async function runWorkflowScript(body: string, globals: ScriptGlobals, filename = "workflow.js"): Promise<unknown> {
	const context = vm.createContext({ __workflow__: globals }, { codeGeneration: { strings: false, wasm: false } });
	let completion: unknown;
	try {
		const script = new vm.Script(wrapScriptBody(body), { filename });
		completion = script.runInContext(context, { timeout: SYNC_TIMEOUT_MS });
	} catch (error) {
		throw error instanceof WorkflowScriptError ? error : new WorkflowScriptError(`Workflow script failed: ${(error as Error).message}`);
	}
	// The wrap's final statement is the async IIFE, so the completion value is
	// the promise of the script's own result (including a top-level `return`).
	return await Promise.resolve(completion);
}
