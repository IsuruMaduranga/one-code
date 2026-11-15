/**
 * user-message extension: how the transcript shows a user message. It owns
 * the one Markdown transformer for user messages (lib/ui/user-message.ts has
 * the pipeline and why there is one): a notification that opened a turn
 * shows its headline, a typed command its command line, and with the
 * branding feature on the message gets Claude Code's `❯` pointer.
 *
 * Required: the first two rewrites are what makes the harness's own text in
 * a user message readable, so they must not depend on a cosmetic feature a
 * profile can turn off. Display only; requests are untouched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { feature } from "../../lib/profile/feature.ts";
import { featureEnabled } from "../../lib/profile/profile.ts";
import { paintedUserMarker, userMessageMarkdown } from "../../lib/ui/user-message.ts";

function userMessageExtension(pi: ExtensionAPI) {
	// The pointer is branding's look: on with the feature, painted from the
	// live theme pi hands the session.
	const marked = featureEnabled("branding");
	let theme: unknown;
	pi.on("session_start", (_event, ctx) => {
		theme = ctx.ui.theme;
	});
	pi.registerMarkdownTransformer((markdown, context) =>
		context.messageType === "user" ? userMessageMarkdown(markdown, marked ? paintedUserMarker(theme) : undefined) : markdown,
	);
}

export default feature("user-message", userMessageExtension);
