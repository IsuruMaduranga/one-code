/**
 * Emitted by the send-now extension just before it aborts a turn to deliver
 * the queued messages, so the interrupted extension skips its "Interrupted ·
 * What should One Code do instead?" note for that abort: the user has already
 * said what to do instead.
 */
export const SEND_NOW_CHANNEL = "one-code:send-now";
