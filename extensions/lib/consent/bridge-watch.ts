/**
 * Subscribe to a bus channel on which a parent extension publishes a bridge
 * (a closure pair a child session calls back into), and return a lazy getter
 * for the latest one. The permission bridge and the hook bridge share this
 * shape: the getter is threaded into child runners and yields `undefined` until
 * the owning extension publishes at session start. Call once from an extension
 * entry point — only they hold a `pi`.
 */

export interface BridgeWatchApi {
	events: { on(channel: string, handler: (data: unknown) => void): void };
}

export function watchBridge<T>(pi: BridgeWatchApi, channel: string, pick: (data: unknown) => T | undefined): () => T | undefined {
	let bridge: T | undefined;
	pi.events.on(channel, (data) => {
		bridge = pick(data);
	});
	return () => bridge;
}
