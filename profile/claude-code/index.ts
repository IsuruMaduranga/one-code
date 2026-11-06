/**
 * One Code's instruction provider, loaded the first time a session asks for
 * instruction files rather than with the profile: the provider reads files
 * through lib/ modules (paths, settings, rules) that a profile import must
 * not pull in early. Under test, test/setup.ts loads the profile before a
 * test file's own mocks exist, and every module loaded then stays unmocked
 * for that file. Shared once per process like the profile itself
 * (lib/shared-module.ts): it holds no state.
 */

import { fileURLToPath } from "node:url";
import type { InstructionProvider } from "../../extensions/lib/instructions.ts";
import { sharedModule } from "../../extensions/lib/shared-module.ts";

/** The slot the provider module is shared under; test/setup.ts fills it from its own import. */
export const INSTRUCTION_PROVIDER = "one-code:claude-code-instructions";
const PROVIDER_MODULE = fileURLToPath(new URL("./instructions.ts", import.meta.url));

export const claudeCodeInstructions: InstructionProvider = {
	open: (opts) => sharedModule<typeof import("./instructions.ts")>(INSTRUCTION_PROVIDER, PROVIDER_MODULE).claudeCodeInstructions.open(opts),
};
