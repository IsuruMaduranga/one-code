/**
 * The first-message context words in force: the base's words
 * (context-text.ts) with the profile's part. Fails closed (`requireText`)
 * without that part: every session sends the context.
 */

import { memoOn } from "../core/text-spans.ts";
import { requireText } from "../profile/profile.ts";
import { type ContextWords, contextText } from "./context-text.ts";

const built = memoOn(contextText);

export const contextWords = (): ContextWords => built(requireText("context"));
