/**
 * A stand-in for `ctx.modelRegistry.streamSimple` in side-call tests. Side
 * calls send through pi's model runtime, which resolves the model's credential
 * itself (`ModelRuntime.prepareRequest`): the base URL onto the model, the
 * key, the resolved headers under the call's own, the env. This applies a
 * test's resolved `auth` the same way and hands the call to `complete` (a
 * `vi.fn`), whose return value is the reply. The real runtime is exercised in
 * anthropic-stream.test.ts.
 */

export interface FakeAuth {
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	baseUrl?: string;
}

type Complete = (model: never, context: never, options: never) => unknown;

export function registryStream(complete: Complete, auth: FakeAuth = {}) {
	return (model: { baseUrl?: string }, context: unknown, options?: { headers?: Record<string, string | null> }) => {
		const sentModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
		const headers = auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined;
		const sentOptions = { ...options, apiKey: auth.apiKey, headers, env: auth.env };
		const reply = Promise.resolve().then(() => complete(sentModel as never, context as never, sentOptions as never));
		return { result: () => reply };
	};
}
