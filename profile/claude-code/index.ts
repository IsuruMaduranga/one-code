/**
 * One Code's instruction provider, loaded the first time a session asks for
 * instruction files rather than with the profile: the provider reads files
 * through lib/ modules (paths, settings, rules) that a profile import must
 * not pull in early. Under test, test/setup.ts loads the profile before a
 * test file's own mocks exist, and every module loaded then stays unmocked
 * for that file. Shared through a `Symbol.for` slot like the profile itself
 * (lib/profile.ts `shippedProfile`): it holds no state.
 */

import { createRequire } from "node:module";
import type { InstructionProvider } from "../../extensions/lib/instructions.ts";

const PROVIDER = Symbol.for("one-code:claude-code-instructions");

function provider(): InstructionProvider {
	const slot = globalThis as { [PROVIDER]?: InstructionProvider };
	if (!slot[PROVIDER]) {
		const load = typeof require === "function" ? require : createRequire(import.meta.url);
		slot[PROVIDER] = (load("./instructions.ts") as typeof import("./instructions.ts")).claudeCodeInstructions;
	}
	return slot[PROVIDER];
}

/** Puts the test run's own provider in the slot (test/setup.ts), loaded through vitest's module graph. */
export function shareInstructionProviderForTest(instructions: InstructionProvider): void {
	(globalThis as { [PROVIDER]?: InstructionProvider })[PROVIDER] = instructions;
}

export const claudeCodeInstructions: InstructionProvider = { open: (opts) => provider().open(opts) };
