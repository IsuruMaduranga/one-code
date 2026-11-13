/**
 * The first-message context words in force: the base's words
 * (context-text.ts) with the profile's part. Fails closed (`requireText`)
 * without that part: every session sends the context.
 */

import { wordsInForce } from "../profile/live-words.ts";
import { type ContextWords, contextText } from "./context-text.ts";

export const contextWords: () => ContextWords = wordsInForce("context", contextText);
