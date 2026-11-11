/**
 * The first-message context words in force: the base's words
 * (context-text.ts) with the profile's part. Fails closed (`requireText`)
 * without that part: every session sends the context.
 */

import { requireText } from "../profile/profile.ts";
import { type ContextWords, contextText } from "./context-text.ts";

const built = new WeakMap<object, ContextWords>();

export function contextWords(): ContextWords {
	const product = requireText("context");
	let words = built.get(product);
	if (!words) built.set(product, (words = contextText(product)));
	return words;
}
