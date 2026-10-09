/** Serialize startup consent modals over the event bus (jiti modules cannot share a queue). */
const CHANNEL = "one-code:consent-dialog";
interface Events {
	emit(channel: string, data: unknown): void;
	on(channel: string, listener: (data: unknown) => void): unknown;
}
interface Request {
	show: (signal?: AbortSignal) => Promise<unknown>;
	/** External includes are the last startup consent, after hooks and MCP. */
	afterStartup?: boolean;
	result?: Promise<unknown>;
}

/** The early claude-context extension owns the queue and resets it with its session. */
export function installConsentDialogs(events: Events): () => void {
	let controller = new AbortController();
	let tail: Promise<unknown> = Promise.resolve();
	let startupReady = false;
	let waiting: Array<() => void> = [];
	events.on(CHANNEL, (data) => {
		if ((data as { ready?: boolean }).ready) {
			startupReady = true;
			const pending = waiting;
			waiting = [];
			for (const enqueue of pending) enqueue();
			return;
		}
		const request = data as Request;
		const signal = controller.signal;
		let enqueue!: () => void;
		request.result = new Promise((resolve, reject) => {
			const abort = () => resolve(undefined);
			signal.addEventListener("abort", abort, { once: true });
			enqueue = () => {
				const previous = tail;
				tail = request.result!.catch(() => {});
				previous.then(() => signal.aborted ? undefined : request.show(signal)).then(resolve, reject)
					.finally(() => signal.removeEventListener("abort", abort));
			};
		});
		if (request.afterStartup && !startupReady) waiting.push(enqueue);
		else enqueue();
	});
	return () => {
		controller.abort();
		controller = new AbortController();
		tail = Promise.resolve();
		startupReady = false;
		waiting = [];
	};
}

/** MCP finishes registering startup prompts; the first turn is the fallback when MCP is not loaded. */
export function startupConsentReady(events: Pick<Events, "emit">): void {
	events.emit(CHANNEL, { ready: true });
}

/** Without the owner (an extension loaded alone), retain the normal direct-dialog behavior. */
export function consentDialog<T>(events: Pick<Events, "emit">, show: (signal?: AbortSignal) => Promise<T>, afterStartup = false): Promise<T | undefined> {
	const request: Request = { show, afterStartup };
	events.emit(CHANNEL, request);
	return (request.result ?? show()) as Promise<T | undefined>;
}
