/**
 * Facts about the pi-ai this process runs that extensions cannot see in a
 * request: read once from pi-ai's own exports, the same on every pi in the
 * peer range (an export the running pi-ai lacks reads as undefined).
 */

import * as piAi from "@earendil-works/pi-ai";
import { type ResponsesSessionHeader, responsesSessionHeader } from "./request-replay.ts";

/** The header the running pi-ai names an OpenAI Responses session in (request-replay.ts `responsesSessionHeader`). */
export const RESPONSES_SESSION_HEADER: ResponsesSessionHeader = responsesSessionHeader((piAi as Record<string, unknown>).PI_AI_VERSION);
