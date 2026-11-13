/**
 * A user's wording for pi's own tools, in an in-process child session
 * (lib/agents/child-extensions.ts). A child runs pi's built-in read, write,
 * edit and search tools as they are, so nothing registers them where the
 * profile's wording is applied (lib/profile/feature.ts). This entry registers
 * again, unchanged, only the ones the user's own profile words
 * (lib/profile/user-profile.ts); with no such wording it registers nothing,
 * and a child's request is what it was.
 */
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { perCwd } from "../../lib/core/per-cwd.ts";
import { feature } from "../../lib/profile/feature.ts";
import { activeProfile } from "../../lib/profile/profile.ts";

type Builtin = ToolDefinition<any, any, any> & { name: string };

const CREATORS = [createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition] as unknown as Array<(cwd: string) => Builtin>;

function childToolStyleExtension(pi: ExtensionAPI) {
	const worded = activeProfile().user?.toolWording;
	if (!worded || worded.size === 0) return;
	for (const create of CREATORS) {
		const base = create(process.cwd());
		if (!worded.has(base.name)) continue;
		const forCwd = perCwd(create);
		// `pi` here is the profile's view of it, which puts the user's wording on the description.
		pi.registerTool({
			...base,
			execute: (toolCallId, params, signal, onUpdate, ctx: ExtensionToolContext) => forCwd(ctx.cwd).execute(toolCallId, params as never, signal, onUpdate, ctx),
		} as ToolDefinition);
	}
}

export default feature("tool-style", childToolStyleExtension);
