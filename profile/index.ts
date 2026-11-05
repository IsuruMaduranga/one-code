/**
 * One Code's profile: everything that makes the base harness One Code
 * (working-docs/decisions/bi-fork.md). A product built on the base replaces
 * this folder with its own implementation of `Profile`
 * (extensions/lib/profile-contract.ts).
 *
 * One Code runs every feature and keeps each tool's base switches. Its text
 * lives beside this file, one folder per group (system-prompt/ so far).
 */

import type { Profile } from "../extensions/lib/profile-contract.ts";
import { askUser } from "./ask-user/index.ts";
import { notebook } from "./notebook/index.ts";
import { systemPrompt } from "./system-prompt/index.ts";

export const profile: Profile = {
	features: {},
	tools: {},
	childExtensions: [],
	text: { systemPrompt, notebook, askUser },
};
