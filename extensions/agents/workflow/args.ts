/** The workflow tool's argument preparation (pure). */

/**
 * The call's arguments with `args` as the script should see it, decoded before
 * the gate, hooks and the stored call see them. Weak models send a list or
 * object as a JSON-encoded string despite the description (every Qwen 3.8
 * model, battery round 7), which breaks `args.map` and `pipeline(args, …)`; a
 * string that parses to an array or object is decoded. Any other value passes
 * verbatim.
 */
export function prepareWorkflowArguments(raw: unknown): unknown {
	if (!raw || typeof raw !== "object" || !("args" in raw)) return raw;
	return { ...raw, args: decodedArgs((raw as { args: unknown }).args) };
}

function decodedArgs(args: unknown): unknown {
	if (typeof args !== "string" || !/^\s*[[{]/.test(args)) return args;
	try {
		const parsed: unknown = JSON.parse(args);
		return parsed !== null && typeof parsed === "object" ? parsed : args;
	} catch {
		return args;
	}
}
